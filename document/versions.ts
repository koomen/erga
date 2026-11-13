// A document's versions: snapshots of its whole file set (every page, style,
// script and image), cut now and then as it's edited: its history, to look
// back at and restore. Readers always see the document as it is now.
//
// Storage is the document's own (its Durable Object, cloudflare/objects/document.ts),
// behind the small `KV` interface so the unit tests run it on a Map, and the
// blob store (R2: document/blobs.ts). Files are content-addressed blobs, by
// their sha-256, shared by every version that has them, so a version that
// changes one file stores that one file; a version itself (`versions/<n>`)
// is a manifest, path -> sha-256 (a tree of hashes), plus who made it, when,
// and its description. Every blob a version has is in the blob store (in
// the object, `blobs/<sha-256>`, only where there is no blob store: the
// tests). A `blobs/` value an older server left in the object beside the
// blob store is never read. A file that is a blob already
// (an upload: its BlobRef) goes into a version by its hash, with no bytes read.
//
// When a version is cut (history.ts decides, in `noteEdit`), and what's
// in it, is the caller's: this file stores and reads them, says what changed (`changes`, a compact diff), and writes the
// fallback description used when no model writes one.

import { hunks, unifiedPatch } from "../shared/diff.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { LanguageModel, Prompt } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { TEXT_MAX, type BlobRef, type BlobStore } from "./blobs.ts";
import { sha256Hex } from "../shared/bytes.ts";
import { isTextPath } from "./content.ts";
import { io, type StoreError } from "./room.ts";

/** A version as the API shows it (the contract shared with the settings UI, client/pages/versions.ts, and the homepage deploy, server/home/deploys.ts). */
export interface Version {
  id: string;
  /** 1, 2, 3... per document. */
  n: number;
  /** When it was cut (ISO time). */
  at: string;
  /** Who edited since the version before: logins, and agents ("koomen’s agent"). */
  authors: string[];
  /** Five words on what changed, from the model (null until it answers), or the fallback. */
  description: string | null;
}

/** What versions answers (without from or to), but canEdit (the operation adds it); `pending`: edits since the current version. */
export interface VersionsState { current: Version; versions: Version[]; total: number; pending: boolean }

/** A restore: the new current version, the version it came from, and the files it brought back. */
export type RestoreResult = { ok: true; current: Version; from: string; files: string[] } | { ok: false; status: number; error: string };

/** A version as stored: also its files (path -> digest), the document's page then, and its folders made as such (empty ones too). */
export interface StoredVersion extends Version { files: Record<string, string>; index: string; folders?: string[] }

/** The storage a document's versions live in: Durable Object storage's shape (get and put of many keys at once). */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  put(entries: Record<string, unknown>): Promise<void>;
}

const HEAD = "versions/head", VERSION = "versions/", BLOB = "blobs/";
/** Durable Object storage takes at most 128 keys in one get or put. */
const BATCH = 128;
/** How many blobs a version's read asks the blob store for at once. */
const READS = 16;
const key = (n: number) => VERSION + String(n).padStart(8, "0");
export const versionId = (n: number) => `v${n}`;
/** A version's number from its id ("v3"), its number ("3", 3), or null. */
export function versionNumber(ref: unknown): number | null {
  const m = typeof ref == "number" ? String(ref) : typeof ref == "string" ? /^v?(\d{1,8})$/.exec(ref.trim())?.[1] : null;
  const n = m ? Number(m) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const publicVersion = (v: StoredVersion): Version => ({ id: v.id, n: v.n, at: v.at, authors: v.authors, description: v.description });

export class Versions {
  /** Versions already read, by number: they never change, except their description. */
  private cache = new Map<number, StoredVersion>();
  constructor(private kv: KV, private now: () => number = Date.now, private blobs?: BlobStore) {}

  /** The latest version's number (0: none yet). */
  get head(): Effect.Effect<number, StoreError> {
    return io(async () => (await this.kv.get<number>(HEAD)) ?? 0);
  }

  get(n: number): Effect.Effect<StoredVersion | null, StoreError> {
    const hit = this.cache.get(n);
    if (hit) return Effect.succeed(hit);
    const self = this;
    return Effect.gen(function* () {
      const v = yield* io(() => self.kv.get<StoredVersion>(key(n)));
      if (v) self.cache.set(n, v);
      return v ?? null;
    });
  }

  get latest(): Effect.Effect<StoredVersion | null, StoreError> {
    return Effect.flatMap(this.head, (n) => (n ? this.get(n) : Effect.succeed(null)));
  }

  /**
   * Cuts a version of `files` (every file the document holds now: its bytes,
   * or a blob's ref), unless nothing changed since the latest one: then null.
   * Only blobs storage doesn't have yet are written.
   */
  cut(
    files: Map<string, Uint8Array | BlobRef>,
    index: string,
    authors: string[],
    description: string | null = null,
    folders: string[] = []
  ): Effect.Effect<{ version: StoredVersion; previous: StoredVersion | null } | null, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const previous = yield* self.latest;
      const manifest: Record<string, string> = {};
      const bytesOf = new Map<string, Uint8Array>();
      for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (!(data instanceof Uint8Array)) { manifest[path] = data.hash; continue; }
        const digest = yield* io(() => sha256Hex(data));
        manifest[path] = digest;
        bytesOf.set(digest, data);
      }
      const dirs = [...new Set(folders)].sort();
      if (previous && sameFiles(previous.files, manifest) && previous.index == index && (previous.folders ?? []).join("\n") == dirs.join("\n")) return null;
      // Blobs the latest version has are stored; the rest are checked, and written if they're new.
      const known = new Set(previous ? Object.values(previous.files) : []);
      const unknown = [...bytesOf.keys()].filter((d) => !known.has(d));
      const missing: Record<string, Uint8Array> = {};
      const blobs = self.blobs;
      for (let i = 0; i < unknown.length; i += BATCH) {
        const chunk = unknown.slice(i, i + BATCH);
        if (blobs) {
          for (const d of chunk)
            if (!(yield* io(() => blobs.head(d)))) yield* io(() => blobs.put(d, bytesOf.get(d)!, bytesOf.get(d)!.length));
          continue;
        }
        const have = yield* io(() => self.kv.get<Uint8Array>(chunk.map((d) => BLOB + d)));
        for (const d of chunk) if (!have.has(BLOB + d)) missing[BLOB + d] = bytesOf.get(d)!;
      }
      const entries = Object.entries(missing);
      for (let i = 0; i < entries.length; i += BATCH) yield* io(() => self.kv.put(Object.fromEntries(entries.slice(i, i + BATCH))));
      const n = (previous?.n ?? 0) + 1;
      const version: StoredVersion = {
        id: versionId(n),
        n,
        at: new Date(self.now()).toISOString(),
        authors: [...new Set(authors)].sort(),
        description,
        files: manifest,
        index,
        ...(dirs.length ? { folders: dirs } : {}),
      };
      yield* io(() => self.kv.put({ [key(n)]: version, [HEAD]: n }));
      self.cache.set(n, version);
      return { version, previous };
    });
  }

  /** Sets a version's description (the model's five words). */
  describe(n: number, description: string): Effect.Effect<void, StoreError> {
    return Effect.flatMap(this.get(n), (v) => {
      if (!v) return Effect.void;
      const next = { ...v, description };
      return io(() => this.kv.put({ [key(n)]: next })).pipe(
        Effect.map(() => {
          this.cache.set(n, next);
        })
      );
    });
  }

  /** Versions newest first: `limit` of them, before version `before` (or from the latest), and how many there are. */
  list(opts: { before?: number | null; limit?: number } = {}): Effect.Effect<{ versions: StoredVersion[]; total: number }, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const total = yield* self.head;
      const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
      const from = Math.min(total, opts.before != null ? opts.before - 1 : total);
      const want: number[] = [];
      for (let n = from; n > 0 && want.length < limit; n--) want.push(n);
      const missing = want.filter((n) => !self.cache.has(n));
      if (missing.length) {
        const got = yield* io(() => self.kv.get<StoredVersion>(missing.map(key)));
        for (const n of missing) {
          const v = got.get(key(n));
          if (v) self.cache.set(n, v);
        }
      }
      return { versions: want.map((n) => self.cache.get(n)).filter((v): v is StoredVersion => !!v), total };
    });
  }

  /** A blob's bytes: from the blob store (from the object, without one); null if it isn't there. */
  private async blob(digest: string): Promise<Uint8Array | null> {
    return this.blobs ? await this.blobs.bytes(digest) : ((await this.kv.get<Uint8Array>(BLOB + digest)) ?? null);
  }

  /** One file of a version (null if it has no such file). */
  file(v: StoredVersion, path: string): Effect.Effect<Uint8Array | null, StoreError> {
    const digest = v.files[path];
    if (!digest) return Effect.succeed(null);
    return io(() => this.blob(digest));
  }

  /** Every file of a version. */
  files(v: StoredVersion): Effect.Effect<Map<string, Uint8Array>, StoreError> {
    return Effect.map(
      Effect.forEach(Object.entries(v.files), ([p, digest]) => io(async () => [p, await this.blob(digest)] as const), {
        concurrency: READS,
      }),
      (got) => new Map(got.filter((e): e is [string, Uint8Array] => !!e[1]))
    );
  }

  /**
   * Every file of a version as a restore takes it: text as bytes, any
   * other file as a blob's ref, with no bytes read; left out if no store
   * has it. Without a blob store, every file as bytes.
   */
  entries(v: StoredVersion): Effect.Effect<Map<string, Uint8Array | BlobRef>, StoreError> {
    const blobs = this.blobs;
    if (!blobs) return this.files(v);
    const one = async (p: string, hash: string): Promise<Uint8Array | BlobRef | null> => {
      const there = await blobs.head(hash);
      if (!there) return null;
      // A text file comes back as text (it may be one): its bytes.
      const bytes = isTextPath(p) && there.size <= TEXT_MAX ? await blobs.bytes(hash) : null;
      return bytes ?? { hash, size: there.size, at: this.now() };
    };
    return Effect.map(
      Effect.forEach(Object.entries(v.files), ([p, hash]) => io(async () => [p, await one(p, hash)] as const), { concurrency: READS }),
      (got) => new Map(got.filter((e): e is [string, Uint8Array | BlobRef] => !!e[1]))
    );
  }

  /** What changed from `previous` to `version`: files added, removed and changed, and a compact diff of the text. */
  changes(previous: StoredVersion | null, version: StoredVersion, maxChars = 6000): Effect.Effect<Changes, StoreError> {
    const self = this;
    return Effect.gen(function* () {
      const before = previous?.files ?? {};
      const added = Object.keys(version.files).filter((p) => !(p in before));
      const removed = Object.keys(before).filter((p) => !(p in version.files));
      const changed = Object.keys(version.files).filter((p) => p in before && before[p] != version.files[p]);
      const parts: string[] = [];
      let used = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
      const text = (b: Uint8Array | null) => { try { return b ? decoder.decode(b) : ""; } catch { return null; } };
      for (const path of [...changed, ...added]) {
        if (used >= maxChars) { parts.push(`(and more)`); break; }
        const now = text(yield* self.file(version, path));
        const was = previous && path in before ? text(yield* self.file(previous, path)) : "";
        if (now == null || was == null) {
          parts.push(`${path}: binary file ${path in before ? "changed" : "added"}`);
          continue;
        }
        const body = hunks(was, now, 1)
          .map((h) => h.lines.map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l)).join("\n"))
          .join("\n…\n");
        const piece = `--- ${path}${path in before ? "" : " (new file)"}\n${body}`;
        parts.push(piece.slice(0, Math.max(200, maxChars - used)));
        used += piece.length;
      }
      for (const path of removed) parts.push(`${path}: deleted`);
      return { added, removed, changed, diff: parts.join("\n\n") };
    });
  }
}

export interface Changes { added: string[]; removed: string[]; changed: string[]; diff: string }

/**
 * A unified diff for each file that differs from `before` to `after` (two
 * whole file sets, path -> bytes): changed files first, then added, then
 * removed, each in path order; `path` keeps one file (or the files in that
 * folder). Binary files say only that they changed. The text stops at about
 * `maxChars`, with a note of the files it left out. Empty if nothing differs.
 */
export function unifiedDiff(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>, opts: { path?: string; context?: number; maxChars?: number } = {}): { files: string[]; diff: string } {
  const want = opts.path?.replace(/^\.?\//, "").replace(/\/$/, "");
  const wanted = (p: string) => !want || p == want || p.startsWith(want + "/");
  const same = (a: Uint8Array, b: Uint8Array) => a.length == b.length && a.every((x, i) => x == b[i]);
  const rank = (p: string) => (before.has(p) && after.has(p) ? 0 : after.has(p) ? 1 : 2);
  const files = [...new Set([...before.keys(), ...after.keys()])].filter(wanted)
    .filter((p) => !before.has(p) || !after.has(p) || !same(before.get(p)!, after.get(p)!))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const text = (b: Uint8Array | undefined) => { if (!b) return ""; try { return decoder.decode(b); } catch { return null; } };
  const max = opts.maxChars ?? 50 * 1024;
  const cut = (i: number) => `[The diff stops here, at about ${Math.round(max / 1024)}KB. Not shown: ${files.slice(i).join(", ")}. Pass path for one file.]`;
  const parts: string[] = [];
  let used = 0;
  for (const [i, path] of files.entries()) {
    const was = before.get(path), now = after.get(path);
    const a = text(was), b = text(now);
    let piece: string;
    if (a == null || b == null) piece = `Binary file ${path} ${!was ? "added" : !now ? "deleted" : "changed"} (${was?.length ?? 0} -> ${now?.length ?? 0} bytes)`;
    else {
      piece = unifiedPatch(was ? `a/${path}` : "/dev/null", now ? `b/${path}` : "/dev/null", a, b, opts.context ?? 3).trimEnd();
      if (!was) piece = `new file ${path}\n${piece}`;
      else if (!now) piece = `deleted file ${path}\n${piece}`;
    }
    if (used > 0 && used + piece.length > max) {
      parts.push(cut(i));
      break;
    }
    parts.push(
      piece.length > max
        ? `${piece.slice(0, max)}\n[${path}'s diff is cut here: pass path, and a smaller context, or read with version.]`
        : piece
    );
    used += piece.length;
  }
  return { files, diff: parts.join("\n") };
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length == kb.length && ka.every((k) => a[k] == b[k]);
}

/**
 * The description when no model writes one (no API key, the test suite's
 * scripted model, or the model failing): what happened to which files, in
 * a few words. "Edited index.html and style.css", "Added logo.png", "Edited
 * index.html and 3 more files".
 */
export function fallbackDescription(c: Pick<Changes, "added" | "removed" | "changed">, first = false): string {
  if (first) return "First version";
  const name = (paths: string[]) => paths.length == 1 ? paths[0] : paths.length == 2 ? `${paths[0]} and ${paths[1]}` : `${paths[0]} and ${paths.length - 1} more files`;
  const verbs: string[] = [];
  if (c.changed.length) verbs.push(`Edited ${name(c.changed)}`);
  if (c.added.length) verbs.push(`${verbs.length ? "added" : "Added"} ${name(c.added)}`);
  if (c.removed.length) verbs.push(`${verbs.length ? "removed" : "Removed"} ${name(c.removed)}`);
  return verbs.length ? verbs.slice(0, 2).join(", ") : "No changes";
}

/** The model that writes descriptions: the latest Sonnet (agents/document/session.ts's MODELS.sonnet). */
export const DESCRIBE_MODEL = "claude-sonnet-5-5";

const DESCRIBE_SYSTEM =
  'You name changes to a document (a web page and its files) the way a good commit title does. Reply with exactly five words describing what changed for a reader of the page: plain words, sentence case, no quotes, no final period. Describe the content change ("Tightened the pricing section intro"), not the mechanics ("Edited index.html").';

/**
 * Five words on a change, from the model, given the compact diff; null if it
 * can't (no answer, a refusal, an error), and the caller uses the fallback.
 * One retry, and 30 seconds for each try.
 */
export function describeChange(
  apiKey: string,
  changes: Changes,
  used: (input: number, output: number) => void = () => {}
): Effect.Effect<string | null> {
  const files = [
    changes.changed.length ? `Changed: ${changes.changed.join(", ")}` : "",
    changes.added.length ? `Added: ${changes.added.join(", ")}` : "",
    changes.removed.length ? `Deleted: ${changes.removed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // The provider's code is large, and only a description needs it: it loads here, so the Worker starts without it.
  const model = Layer.unwrap(
    Effect.promise(() => import("@effect/ai-anthropic")).pipe(
      Effect.map(({ AnthropicClient, AnthropicLanguageModel }) =>
        AnthropicLanguageModel.layer({
          model: DESCRIBE_MODEL,
          config: { max_tokens: 2000, output_config: { effort: "low" } },
        }).pipe(Layer.provide(AnthropicClient.layer({ apiKey: Redacted.make(apiKey) })), Layer.provide(FetchHttpClient.layer))
      )
    )
  );
  return LanguageModel.generateText({
    prompt: Prompt.make([
      { role: "system", content: DESCRIBE_SYSTEM },
      { role: "user", content: [{ type: "text", text: `${files}\n\nThe diff ("-" removed, "+" added):\n\n${changes.diff}` }] },
    ]),
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.retry(Schedule.recurs(1)),
    Effect.tap((r) => Effect.sync(() => used(r.usage.inputTokens.total ?? 0, r.usage.outputTokens.total ?? 0))),
    Effect.map((r) => (r.finishReason == "content-filter" ? null : cleanDescription(r.text))),
    Effect.provide(model),
    Effect.catch((e) => Effect.as(Effect.log(`couldn't describe a version: ${e.message}`), null))
  );
}

/** The model's answer as a description: one line, no quotes or final period, at most eight words. */
export function cleanDescription(text: string): string | null {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const words = line.replace(/^["'“‘]+|["'”’.]+$/g, "").split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 8).join(" ") : null;
}
