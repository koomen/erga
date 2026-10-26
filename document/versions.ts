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
// and its description. Every blob a version has is in the blob store; one of
// at most OBJECT_MAX bytes is in the object too (`blobs/<sha-256>`), as
// before the blob store, so a Worker from before it still reads every
// version but those holding a bigger file. A file that is a blob already
// (an upload: its BlobRef) goes into a version by its hash, with no bytes read.
//
// When a version is cut (document.ts decides, in `noteEdit`), and what's
// in it, is the caller's: this file stores and reads them, says what changed (`changes`, a compact diff), and writes the
// fallback description used when no model writes one.

import { createTwoFilesPatch, structuredPatch } from "diff";
import Anthropic from "@anthropic-ai/sdk";
import { OBJECT_MAX, TEXT_MAX, type BlobRef, type BlobStore } from "./blobs.ts";
import { sha256Hex } from "../shared/bytes.ts";
import { isTextPath } from "./content.ts";

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

/** What GET /api/docs/<id>/versions answers, but canEdit (the front door adds it); `pending`: edits since the current version. */
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
  async head(): Promise<number> {
    return (await this.kv.get<number>(HEAD)) ?? 0;
  }

  async get(n: number): Promise<StoredVersion | null> {
    const hit = this.cache.get(n);
    if (hit) return hit;
    const v = await this.kv.get<StoredVersion>(key(n));
    if (v) this.cache.set(n, v);
    return v ?? null;
  }

  async latest(): Promise<StoredVersion | null> {
    const n = await this.head();
    return n ? this.get(n) : null;
  }

  /**
   * Cuts a version of `files` (every file the document holds now: its bytes,
   * or a blob's ref), unless nothing changed since the latest one: then null.
   * Only blobs storage doesn't have yet are written.
   */
  async cut(files: Map<string, Uint8Array | BlobRef>, index: string, authors: string[], description: string | null = null, folders: string[] = []): Promise<{ version: StoredVersion; previous: StoredVersion | null } | null> {
    const previous = await this.latest();
    const manifest: Record<string, string> = {};
    const bytesOf = new Map<string, Uint8Array>();
    for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!(data instanceof Uint8Array)) { manifest[path] = data.hash; continue; }
      const digest = await sha256Hex(data);
      manifest[path] = digest;
      bytesOf.set(digest, data);
    }
    const dirs = [...new Set(folders)].sort();
    if (previous && sameFiles(previous.files, manifest) && previous.index == index && (previous.folders ?? []).join("\n") == dirs.join("\n")) return null;
    // Blobs the latest version has are stored; the rest are checked, and written if they're new.
    const known = new Set(previous ? Object.values(previous.files) : []);
    const unknown = [...bytesOf.keys()].filter((d) => !known.has(d));
    const missing: Record<string, Uint8Array> = {};
    for (let i = 0; i < unknown.length; i += BATCH) {
      const chunk = unknown.slice(i, i + BATCH);
      const have = await this.kv.get<Uint8Array>(chunk.map((d) => BLOB + d));
      for (const d of chunk) {
        const bytes = bytesOf.get(d)!;
        // In the blob store too, unless it's there (the object's copy, while one is kept, may predate it).
        if (this.blobs && !(await this.blobs.head(d))) await this.blobs.put(d, bytes, bytes.length);
        if (!have.has(BLOB + d) && (!this.blobs || bytes.length <= OBJECT_MAX)) missing[BLOB + d] = bytes;
      }
    }
    const entries = Object.entries(missing);
    for (let i = 0; i < entries.length; i += BATCH) await this.kv.put(Object.fromEntries(entries.slice(i, i + BATCH)));
    const n = (previous?.n ?? 0) + 1;
    const version: StoredVersion = { id: versionId(n), n, at: new Date(this.now()).toISOString(), authors: [...new Set(authors)].sort(), description, files: manifest, index, ...(dirs.length ? { folders: dirs } : {}) };
    await this.kv.put({ [key(n)]: version, [HEAD]: n });
    this.cache.set(n, version);
    return { version, previous };
  }

  /** Sets a version's description (the model's five words). */
  async describe(n: number, description: string): Promise<void> {
    const v = await this.get(n);
    if (!v) return;
    const next = { ...v, description };
    await this.kv.put({ [key(n)]: next });
    this.cache.set(n, next);
  }

  /** Versions newest first: `limit` of them, before version `before` (or from the latest), and how many there are. */
  async list(opts: { before?: number | null; limit?: number } = {}): Promise<{ versions: StoredVersion[]; total: number }> {
    const total = await this.head();
    const limit = Math.max(1, Math.min(100, opts.limit ?? 10));
    const from = Math.min(total, opts.before != null ? opts.before - 1 : total);
    const want: number[] = [];
    for (let n = from; n > 0 && want.length < limit; n--) want.push(n);
    const missing = want.filter((n) => !this.cache.has(n));
    if (missing.length) {
      const got = await this.kv.get<StoredVersion>(missing.map(key));
      for (const n of missing) { const v = got.get(key(n)); if (v) this.cache.set(n, v); }
    }
    return { versions: want.map((n) => this.cache.get(n)).filter((v): v is StoredVersion => !!v), total };
  }

  /** One file of a version (null if it has no such file): from the object, else the blob store. */
  async file(v: StoredVersion, path: string): Promise<Uint8Array | null> {
    const digest = v.files[path];
    if (!digest) return null;
    return (await this.kv.get<Uint8Array>(BLOB + digest)) ?? (await this.blobs?.bytes(digest)) ?? null;
  }

  /** Every file of a version. */
  async files(v: StoredVersion): Promise<Map<string, Uint8Array>> {
    const paths = Object.keys(v.files);
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      const got = await this.kv.get<Uint8Array>(chunk.map((p) => BLOB + v.files[p]));
      for (const p of chunk) {
        const b = got.get(BLOB + v.files[p]) ?? (await this.blobs?.bytes(v.files[p]));
        if (b) out.set(p, b);
      }
    }
    return out;
  }

  /**
   * Every file of a version as a restore takes it: text (and a small file
   * the object keeps) as bytes, any other file as a blob's ref, with no
   * bytes read; null for one no store has.
   */
  async entries(v: StoredVersion): Promise<Map<string, Uint8Array | BlobRef>> {
    const paths = Object.keys(v.files);
    const out = new Map<string, Uint8Array | BlobRef>();
    for (let i = 0; i < paths.length; i += BATCH) {
      const chunk = paths.slice(i, i + BATCH);
      const got = await this.kv.get<Uint8Array>(chunk.map((p) => BLOB + v.files[p]));
      for (const p of chunk) {
        const hash = v.files[p], b = got.get(BLOB + hash);
        if (b) { out.set(p, b); continue; }
        const there = await this.blobs?.head(hash);
        if (!there) continue;
        // A text file comes back as text (it may be one): its bytes.
        const bytes = isTextPath(p) && there.size <= TEXT_MAX ? await this.blobs!.bytes(hash) : null;
        out.set(p, bytes ?? { hash, size: there.size, at: this.now() });
      }
    }
    return out;
  }

  /** What changed from `previous` to `version`: files added, removed and changed, and a compact diff of the text. */
  async changes(previous: StoredVersion | null, version: StoredVersion, maxChars = 6000): Promise<Changes> {
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
      const now = text(await this.file(version, path));
      const was = previous && path in before ? text(await this.file(previous, path)) : "";
      if (now == null || was == null) { parts.push(`${path}: binary file ${path in before ? "changed" : "added"}`); continue; }
      const patch = structuredPatch(path, path, was, now, undefined, undefined, { context: 1 });
      const body = patch.hunks.map((h) => h.lines.map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l)).join("\n")).join("\n…\n");
      const piece = `--- ${path}${path in before ? "" : " (new file)"}\n${body}`;
      parts.push(piece.slice(0, Math.max(200, maxChars - used)));
      used += piece.length;
    }
    for (const path of removed) parts.push(`${path}: deleted`);
    return { added, removed, changed, diff: parts.join("\n\n") };
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
      piece = createTwoFilesPatch(was ? `a/${path}` : "/dev/null", now ? `b/${path}` : "/dev/null", a, b, undefined, undefined, { context: opts.context ?? 3 })
        .replace(/^=+\n/, "").trimEnd();
      if (!was) piece = `new file ${path}\n${piece}`;
      else if (!now) piece = `deleted file ${path}\n${piece}`;
    }
    if (used > 0 && used + piece.length > max) { parts.push(cut(i)); break; }
    parts.push(piece.length > max ? `${piece.slice(0, max)}\n[${path}'s diff is cut here: pass path, and a smaller context, or read_version.]` : piece);
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

/**
 * Five words on a change, from the model, given the compact diff; null if it
 * can't (no answer, a refusal, an error), and the caller uses the fallback.
 */
export async function describeChange(apiKey: string, changes: Changes, fetchImpl?: typeof fetch): Promise<string | null> {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const files = [
    changes.changed.length ? `Changed: ${changes.changed.join(", ")}` : "",
    changes.added.length ? `Added: ${changes.added.join(", ")}` : "",
    changes.removed.length ? `Deleted: ${changes.removed.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  try {
    const response = await client.messages.create({
      model: DESCRIBE_MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      system: "You name changes to a document (a web page and its files) the way a good commit title does. Reply with exactly five words describing what changed for a reader of the page: plain words, sentence case, no quotes, no final period. Describe the content change (\"Tightened the pricing section intro\"), not the mechanics (\"Edited index.html\").",
      messages: [{ role: "user", content: `${files}\n\nThe diff (\"-\" removed, \"+\" added):\n\n${changes.diff}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (response.stop_reason == "refusal") return null;
    const text = response.content.map((b) => (b.type == "text" ? b.text : "")).join(" ").trim();
    return cleanDescription(text);
  } catch (e) {
    console.log(`couldn't describe a version: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** The model's answer as a description: one line, no quotes or final period, at most eight words. */
export function cleanDescription(text: string): string | null {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const words = line.replace(/^["'“‘]+|["'”’.]+$/g, "").split(/\s+/).filter(Boolean);
  return words.length ? words.slice(0, 8).join(" ") : null;
}
