// A document's storage as one value, to copy documents' Durable Objects from
// one server to another: how staging gets production's documents when it
// copies its data (the pipeline's "documents" step, control/deploys/pipeline.ts,
// with control/deploys/copy-documents.ts). The database is copied by D1 itself (export
// and import); a Durable Object's storage can only be read from inside the
// Worker that owns it, so production serves a read-only snapshot endpoint and
// staging an import one, both behind a shared bearer token (SNAPSHOT_TOKEN,
// set on both Workers by deploy/setup.ts). With it staging can read every
// production document, so it is at least 32 characters, compared in constant time:
//
//   POST /api/snapshot/docs          {ids, after?}  → {docs: [{id, entries, alarm, more?}], done, failed}
//                                                     any server with SNAPSHOT_TOKEN: read-only
//   POST /api/snapshot/docs/import   {docs, wipe}   → {imported, wiped}   only with SNAPSHOT_IMPORT=1 and never on production
//
// A document's snapshot is every key in its storage (its files, folders,
// meta, its versions and the room's journal: document/storage.ts) and its
// alarm (when an unedited one expires). Values go as JSON, bytes as base64.
// The export only reads (DocumentObject.exportStorage: storage.list and getAlarm,
// nothing opened); the import empties the document's storage and writes the
// snapshot in.
//
// A document can hold far more than one answer can carry: its versions keep
// every file it ever had, and a value passed to or from a Durable Object is
// at most 32 MiB (RPC_LIMIT). So an answer carries at most SNAPSHOT_BUDGET
// characters of entries: the documents of `ids` in order, the last one maybe
// in part (`more`: the key its next part starts after, asked for as
// `after`). `done` says how many of `ids` it finished, `failed` which ones
// couldn't be read (and why): the others are still copied. A part after the
// first is imported with `append`: added to the earlier ones, nothing emptied.
//
// The same handler runs in the Worker and in the mock
// Cloudflare's pretend servers, so the tests exercise it.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64 } from "effect/encoding";
import { sameText } from "../shared/bytes.ts";

/** One value of a document's storage, as JSON: its bytes as base64 (`b`), or the value itself (`j`). */
const Encoded = Schema.Union([Schema.Struct({ b: Schema.String }), Schema.Struct({ j: Schema.Unknown })]);
export type Encoded = { b: string } | { j: unknown };

const DocId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));

/** A document's storage, or a part of it: `more` on export (another part follows), `append` on import (a part after the first). */
const DocSnapshot = Schema.Struct({
  id: DocId,
  entries: Schema.Array(Schema.Tuple([Schema.String, Encoded])),
  alarm: Schema.optional(Schema.NullOr(Schema.Number)),
  more: Schema.optional(Schema.String),
  append: Schema.optional(Schema.Boolean),
});
export interface DocSnapshot { id: string; entries: [string, Encoded][]; alarm: number | null; more?: string; append?: boolean }
/** Which part of a document's storage: the entries after the key `after` (null: from the first), as many as fit in `budget` characters. */
export interface Page { after: string | null; budget: number }

/** Where documents' storage is, as the snapshot endpoints reach it. */
export interface DocStore {
  /** One part of the document's storage (at least one entry, if any are left), or null if there's no such document. */
  export(id: string, page: Page): Promise<DocSnapshot | null>;
  import(snap: DocSnapshot): Promise<void>;
  wipe(id: string): Promise<void>;
}

/** The most a value passed to or from a Durable Object may be: workerd refuses more ("Serialized RPC ... limited to 32MiB"). */
export const RPC_LIMIT = 32 * 1024 * 1024;
/** The most one value in a Durable Object's (SQLite) storage may be. */
export const VALUE_LIMIT = 2 * 1024 * 1024;
/**
 * Characters of entries in one answer. An answer stops after the entry that
 * reaches it, so it can be one value (VALUE_LIMIT as base64) longer: still
 * far below RPC_LIMIT, and little for the Worker's 128 MB to hold twice.
 */
export const SNAPSHOT_BUDGET = 8 * 1024 * 1024;

export const encodeValue = (v: unknown): Encoded =>
  v instanceof Uint8Array ? { b: Base64.encode(v) } : v instanceof ArrayBuffer ? { b: Base64.encode(new Uint8Array(v)) } : { j: v };
/** A value as storage keeps it; throws on bytes that aren't base64 (the import refuses the snapshot). */
export const decodeValue = (e: Encoded): unknown => ("b" in e ? Result.getOrThrow(Base64.decode(e.b)) : e.j);

/** POST /api/snapshot/docs: which documents, from which key of the first. Ids that aren't one are left out. */
const ExportBody = Schema.Struct({ ids: Schema.optional(Schema.Array(Schema.Unknown)), after: Schema.optional(Schema.Unknown) });
/** POST /api/snapshot/docs/import: the documents' storage to write, and the documents to empty. */
const ImportBody = Schema.Struct({ docs: Schema.optional(Schema.Array(DocSnapshot)), wipe: Schema.optional(Schema.Array(Schema.Unknown)) });
const isDocId = Schema.is(DocId);

/** About how many characters an entry takes in an answer. */
const sizeOf = ([key, e]: [string, Encoded]) => key.length + 16 + ("b" in e ? e.b.length : (JSON.stringify(e.j) ?? "").length);

/**
 * One part of a document's storage, read from `list` (the keys after
 * `after`, in order, at most `limit` of them) until it holds `budget`
 * characters: DocumentObject's export and the in-memory store's.
 */
export async function exportPage(id: string, page: Page, alarm: number | null, list: (after: string | null, limit: number) => Promise<Map<string, unknown>>): Promise<DocSnapshot> {
  const entries: [string, Encoded][] = [];
  let after = page.after, size = 0;
  for (;;) {
    const got = await list(after, 16);
    for (const [k, v] of got) {
      const entry: [string, Encoded] = [k, encodeValue(v)];
      entries.push(entry);
      after = k;
      if ((size += sizeOf(entry)) >= page.budget) return { id, entries, alarm, more: k };
    }
    if (got.size < 16) return { id, entries, alarm };
  }
}

/** The snapshot endpoints' guard: 404 with no SNAPSHOT_TOKEN (or a short one), 403 without it as the bearer, else null. */
export function snapshotRefused(request: Request, token: string | undefined): Response | null {
  const want = token?.trim();
  if (!want || want.length < 32) return Response.json({ error: "Not found" }, { status: 404 });
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return sameText(bearer, want) ? null : Response.json({ error: "Not allowed" }, { status: 403 });
}

/**
 * The snapshot endpoints, or null for any other path. `token`: this server's
 * SNAPSHOT_TOKEN (none: the endpoints aren't there). `importAllowed`: this
 * server takes snapshots in (staging); production never does.
 */
export async function snapshotRoutes(
  request: Request,
  o: { token?: string; importAllowed: boolean; store: DocStore; budget?: number }
): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path != "/api/snapshot/docs" && path != "/api/snapshot/docs/import") return null;
  const refused = snapshotRefused(request, o.token);
  if (refused) return refused;
  if (request.method != "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body: unknown = await request.json().catch(() => null);
  if (path == "/api/snapshot/docs") return Effect.runPromise(exportDocs(body, o.store, o.budget ?? SNAPSHOT_BUDGET));
  if (!o.importAllowed) return Response.json({ error: "Not found" }, { status: 404 });
  return Effect.runPromise(importDocs(body, o.store));
}

/** The export: one document at a time, each in what's left of the budget; the first continues after `after`. A document that fails is listed, not the end. */
const exportDocs = (raw: unknown, store: DocStore, budget: number) =>
  Effect.gen(function* () {
    const body = Option.getOrElse(Schema.decodeUnknownOption(ExportBody)(raw), () => ({}) as typeof ExportBody.Type);
    const ids = (body.ids ?? []).filter(isDocId);
    if (ids.length > 50) return Response.json({ error: "At most 50 documents at a time" }, { status: 400 });
    const docs: DocSnapshot[] = [],
      failed: { id: string; error: string }[] = [];
    let left = budget,
      done = 0;
    for (const id of ids) {
      if (left <= 0) break;
      const after = done == 0 && typeof body.after == "string" ? body.after : null;
      const got = yield* Effect.result(Effect.tryPromise(() => store.export(id, { after, budget: left })));
      if (Result.isFailure(got)) failed.push({ id, error: errorText(got.failure.cause) });
      else if (got.success) {
        docs.push(got.success);
        left -= got.success.entries.reduce((n, e) => n + sizeOf(e), 0);
        if (got.success.more !== undefined) break;
      }
      done++;
    }
    return Response.json({ docs, done, failed });
  });

/** The import: every document's storage, then the documents to empty. A snapshot that doesn't decode is refused whole. */
const importDocs = (raw: unknown, store: DocStore) =>
  Effect.gen(function* () {
    const body = yield* Effect.result(Schema.decodeUnknownEffect(ImportBody)(raw ?? {}));
    if (Result.isFailure(body)) return Response.json({ error: "Bad snapshot" }, { status: 400 });
    const docs = body.success.docs ?? [];
    const wipe = (body.success.wipe ?? []).filter(isDocId);
    for (const d of docs)
      yield* Effect.promise(() =>
        store.import({
          id: d.id,
          entries: d.entries as [string, Encoded][],
          alarm: d.alarm ?? null,
          ...(d.append === true ? { append: true } : {}),
        })
      );
    for (const id of wipe) yield* Effect.promise(() => store.wipe(id));
    return Response.json({ imported: docs.length, wiped: wipe.length });
  });

const errorText = (e: unknown) => (e instanceof Error ? e.message : "") || String(e);

/**
 * An in-memory DocStore: the mock's servers, and the tests'. Like a Durable
 * Object, it refuses to pass a value larger than `rpcLimit` (as JSON).
 */
export function memoryStore(docs: Map<string, { entries: Map<string, unknown>; alarm: number | null }> = new Map()): DocStore & { docs: typeof docs; rpcLimit: number } {
  const store = {
    docs,
    rpcLimit: RPC_LIMIT,
    async export(id: string, page: Page) {
      const d = docs.get(id);
      if (!d) return null;
      const keys = [...d.entries.keys()].sort();
      const snap = await exportPage(id, page, d.alarm, async (after, limit) => {
        const from = after == null ? 0 : keys.findIndex((k) => k > after);
        return new Map(from < 0 ? [] : keys.slice(from, from + limit).map((k) => [k, d.entries.get(k)]));
      });
      return rpc(snap);
    },
    async import(snap: DocSnapshot) {
      rpc(snap);
      const d = snap.append ? docs.get(snap.id) : undefined;
      const entries = d?.entries ?? new Map<string, unknown>();
      for (const [k, e] of snap.entries) entries.set(k, decodeValue(e));
      docs.set(snap.id, { entries, alarm: snap.alarm ?? d?.alarm ?? null });
    },
    async wipe(id: string) { docs.delete(id); },
  };
  const rpc = <T>(value: T): T => {
    const size = JSON.stringify(value).length;
    if (size > store.rpcLimit) throw new Error(`Serialized RPC arguments or return values are limited to ${store.rpcLimit} bytes, but the size of this value was: ${size} bytes.`);
    return value;
  };
  return store;
}
