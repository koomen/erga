// Copying documents' Durable Objects from one server to another: how staging
// gets production's documents on each deploy (the pipeline's "documents"
// step, deploy/cloudflare.ts). The database is copied by D1 itself (export
// and import); a Durable Object's storage can only be read from inside the
// Worker that owns it, so production serves a read-only snapshot endpoint and
// staging an import one, both behind a shared bearer token (SNAPSHOT_TOKEN,
// set on both Workers by deploy/setup.ts). With it staging can read every
// production document, so it is at least 32 characters, compared in constant time:
//
//   POST /api/snapshot/docs          {ids}          → {docs: [{id, entries, alarm}]}   any server with SNAPSHOT_TOKEN: read-only
//   POST /api/snapshot/docs/import   {docs, wipe}   → {imported, wiped}                only with SNAPSHOT_IMPORT=1 and never on production
//
// A document's snapshot is every key in its storage (its files, folders,
// meta and the room's Yjs state: worker/doc-host.ts) and its alarm (when an
// unedited one expires). Values go as JSON, bytes as base64. The export only
// reads (DocHost.exportStorage: storage.list and getAlarm, nothing opened);
// the import empties the document's storage and writes the snapshot in.
//
// The same handler runs in the Worker (worker/index.ts) and in the mock
// Cloudflare's pretend servers (deploy/mock.ts), so the tests exercise it.

import { DeployError, type Fetch } from "./cloudflare";

export type Encoded = { b: string } | { j: unknown };
export interface DocSnapshot { id: string; entries: [string, Encoded][]; alarm: number | null }

/** Where documents' storage is, as the snapshot endpoints reach it. */
export interface DocStore {
  export(id: string): Promise<DocSnapshot | null>;
  import(snap: DocSnapshot): Promise<void>;
  wipe(id: string): Promise<void>;
}

export const encodeValue = (v: unknown): Encoded =>
  v instanceof Uint8Array ? { b: b64(v) } : v instanceof ArrayBuffer ? { b: b64(new Uint8Array(v)) } : { j: v };
export const decodeValue = (e: Encoded): unknown => ("b" in e ? Uint8Array.from(atob(e.b), (c) => c.charCodeAt(0)) : e.j);

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The same strings, compared in time that doesn't depend on where they differ. */
function same(a: string, b: string): boolean {
  if (a.length != b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d == 0;
}

/**
 * The snapshot endpoints, or null for any other path. `token`: this server's
 * SNAPSHOT_TOKEN (none: the endpoints aren't there). `importAllowed`: this
 * server takes snapshots in (staging); production never does.
 */
export async function snapshotDoor(request: Request, o: { token?: string; importAllowed: boolean; store: DocStore }): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (path != "/api/snapshot/docs" && path != "/api/snapshot/docs/import") return null;
  const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
  const token = o.token?.trim();
  if (!token || token.length < 32) return notFound();
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!same(bearer, token)) return Response.json({ error: "Not allowed" }, { status: 403 });
  if (request.method != "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const body = (await request.json().catch(() => null)) as { ids?: unknown; docs?: unknown; wipe?: unknown } | null;
  if (path == "/api/snapshot/docs") {
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id == "string" && ID.test(id)) : [];
    if (ids.length > 50) return Response.json({ error: "At most 50 documents at a time" }, { status: 400 });
    const docs = (await Promise.all(ids.map((id) => o.store.export(id)))).filter((d): d is DocSnapshot => !!d);
    return Response.json({ docs });
  }
  if (!o.importAllowed) return notFound();
  const docs = Array.isArray(body?.docs) ? (body.docs as DocSnapshot[]) : [];
  const wipe = Array.isArray(body?.wipe) ? body.wipe.filter((id): id is string => typeof id == "string" && ID.test(id)) : [];
  for (const d of docs) if (!d || typeof d.id != "string" || !ID.test(d.id) || !Array.isArray(d.entries)) return Response.json({ error: "Bad snapshot" }, { status: 400 });
  for (const d of docs) await o.store.import(d);
  for (const id of wipe) await o.store.wipe(id);
  return Response.json({ imported: docs.length, wiped: wipe.length });
}

/**
 * Copies documents' storage from the server at `from` to the one at `to`:
 * ten at a time, read from one and written to the other; `wipe` empties
 * documents the target had that the source doesn't. `unsupported`: the
 * source has no snapshot endpoint (an older version, or no SNAPSHOT_TOKEN).
 */
export async function copyDocuments(o: { ids: string[]; wipe: string[]; from: string; to: string; token: string; fetch: Fetch; batch?: number }): Promise<{ copied: number; missing: number; wiped: number; unsupported: boolean }> {
  const headers = { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json" };
  const size = o.batch ?? 10;
  let copied = 0, missing = 0;
  const put = async (docs: DocSnapshot[], wipe: string[]) => {
    const r = await o.fetch(`${o.to}/api/snapshot/docs/import`, { method: "POST", headers, body: JSON.stringify({ docs, wipe }) }).catch((e) => { throw new DeployError(`Couldn't reach ${o.to} to copy documents in: ${(e as Error).message}`); });
    if (!r.ok) throw new DeployError(`${o.to} didn't take the documents' copy (it answered ${r.status}${r.status == 404 ? ": it needs SNAPSHOT_IMPORT=1 and SNAPSHOT_TOKEN" : ""}).`);
  };
  for (let i = 0; i < o.ids.length; i += size) {
    const ids = o.ids.slice(i, i + size);
    const r = await o.fetch(`${o.from}/api/snapshot/docs`, { method: "POST", headers, body: JSON.stringify({ ids }) }).catch((e) => { throw new DeployError(`Couldn't reach ${o.from} to read its documents: ${(e as Error).message}`); });
    if (r.status == 404 && i == 0) {
      if (o.wipe.length) await put([], o.wipe);
      return { copied: 0, missing: 0, wiped: o.wipe.length, unsupported: true };
    }
    if (!r.ok) throw new DeployError(`${o.from} didn't give its documents' snapshot (it answered ${r.status}${r.status == 403 ? ": the two servers' SNAPSHOT_TOKEN differ" : ""}).`);
    const { docs } = (await r.json()) as { docs: DocSnapshot[] };
    missing += ids.length - docs.length;
    if (docs.length) await put(docs, []);
    copied += docs.length;
  }
  if (o.wipe.length) await put([], o.wipe);
  return { copied, missing, wiped: o.wipe.length, unsupported: false };
}

/** An in-memory DocStore: the mock's servers, and the tests'. */
export function memoryStore(docs: Map<string, { entries: Map<string, unknown>; alarm: number | null }> = new Map()): DocStore & { docs: typeof docs } {
  return {
    docs,
    async export(id) {
      const d = docs.get(id);
      return d ? { id, entries: [...d.entries].map(([k, v]) => [k, encodeValue(v)]), alarm: d.alarm } : null;
    },
    async import(snap) { docs.set(snap.id, { entries: new Map(snap.entries.map(([k, e]) => [k, decodeValue(e)])), alarm: snap.alarm }); },
    async wipe(id) { docs.delete(id); },
  };
}
