// The storage cutover's two routes, for its scripts (deploy/cutover/): admins
// only, with admin power (a browser session, or an admin-scope token).
//
// GET /api/admin/documents/export: every document on the server.
//
// The answer is one JSON line per document (application/x-ndjson):
//
//   { record, permissions, index, published: { mode, version }, files, publishedFiles? }
//
// `record` is the directory's row (id, owner, slug, title, titleSet,
// slugSet, created, modified, expires, test), `permissions` who has it and
// how, `files` every file as it is now ({ text } or { base64 }), and
// `publishedFiles` the published version's files when it is fixed at one
// (mode "manual") and they differ from the current ones. Test documents are
// left out. A document whose host answers nothing (it was never made) is
// reported as { record, missing: true }.

import { NotAllowed, type Permission, type DocRow } from "../directory.ts";
import type { Platform } from "../routes.ts";
import type { PublishMode, Version } from "../../document/versions.ts";

export interface ExportedFile { text?: string; base64?: string }
export interface ExportedDocument {
  record: DocRow;
  permissions: Permission[];
  index: string;
  published: { mode: PublishMode; version: Version } | null;
  files: Record<string, ExportedFile>;
  publishedFiles?: Record<string, ExportedFile>;
}
export type ExportLine = ExportedDocument | { record: DocRow; missing: true };
/** An exported document on its way into a document's storage: the directory's row for it, its files as bytes. */
export interface ImportedDocument {
  record: DocRow;
  index: string;
  files: Record<string, Uint8Array>;
  publishedFiles?: Record<string, Uint8Array>;
}

/**
 * POST /api/admin/documents/import: one exported document back, under its
 * own id. Its row must be in the directory already (D1 is not part of the
 * cutover), with the same owner; the document itself must not exist yet.
 * Answers { ok: true, versions } (how many versions it has now: two when it
 * was published at another version, else one) or an error (400, 403, 404,
 * 409).
 */
export async function importDocument(platform: Platform, request: Request): Promise<Response> {
  if (request.method != "POST") return json({ error: "Not found" }, 404);
  const session = await platform.sessionOf(request);
  if (!session) return json({ error: "Sign in, or send an admin token." }, 401);
  try { await platform.directory.users.mustAdmin({ login: session.login, admin: session.admin, test: !!session.test }); }
  catch (e) { if (e instanceof NotAllowed) return json({ error: e.message }, 403); throw e; }
  let doc: ExportedDocument;
  try { doc = (await request.json()) as ExportedDocument; } catch { return json({ error: "Send one exported document as JSON." }, 400); }
  if (!doc?.record?.id || typeof doc.record.owner != "string" || typeof doc.index != "string" || !doc.files || typeof doc.files != "object") return json({ error: "Send one exported document: { record, index, files, publishedFiles? }." }, 400);
  const row = await platform.directory.get(doc.record.id);
  if (!row) return json({ error: `The directory has no document ${doc.record.id}.` }, 404);
  if (row.owner != doc.record.owner.toLowerCase()) return json({ error: `The directory's ${doc.record.id} belongs to ${row.owner}, the export's to ${doc.record.owner}.` }, 409);
  // Decoded here: the document runs in its own object, and bytes travel to it where a function would not.
  const imported: ImportedDocument = { record: row, index: doc.index, files: decodeFiles(doc.files) };
  if (doc.publishedFiles) imported.publishedFiles = decodeFiles(doc.publishedFiles);
  const r = await platform.docs.importExported({ id: row.id, owner: row.owner, test: row.test }, imported);
  return r.ok ? json(r) : json({ error: r.error }, 409);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function exportDocuments(platform: Platform, request: Request): Promise<Response> {
  if (request.method != "GET") return json({ error: "Not found" }, 404);
  const session = await platform.sessionOf(request);
  if (!session) return json({ error: "Sign in, or send an admin token." }, 401);
  const dir = platform.directory;
  let docs: DocRow[];
  try { docs = await dir.all({ login: session.login, admin: session.admin, test: !!session.test }); }
  catch (e) { if (e instanceof NotAllowed) return json({ error: e.message }, 403); throw e; }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const record of docs) {
          const line = await exportOne(platform, record);
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Erga-Documents": String(docs.length) } });
}

/** One document's line: its row, who has it, its files, and its published files if fixed at another version. */
export async function exportOne(platform: Platform, record: DocRow): Promise<ExportLine> {
  const route = { id: record.id, owner: record.owner, test: record.test };
  const [permissions, snap] = await Promise.all([platform.directory.permissions(record.id), platform.docs.snapshot(route)]);
  if (!snap) return { record, missing: true };
  const state = await platform.docs.versions(route, { limit: 1 });
  const published = state ? state.published : null;
  const line: ExportedDocument = { record, permissions, index: snap.index, published, files: encodeFiles(snap.files) };
  if (published?.mode == "manual") {
    const pub = await platform.docs.snapshot(route, { published: true });
    if (pub && !sameFiles(pub.files, snap.files)) line.publishedFiles = encodeFiles(pub.files);
  }
  return line;
}

export function encodeFiles(files: Record<string, string | Uint8Array>): Record<string, ExportedFile> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, data]) => [path, typeof data == "string" ? { text: data } : { base64: toBase64(data) }]));
}

/** The bytes of an exported file. */
export function decodeFile(file: ExportedFile): Uint8Array {
  return file.text != null ? new TextEncoder().encode(file.text) : fromBase64(file.base64 ?? "");
}
const decodeFiles = (files: Record<string, ExportedFile>): Record<string, Uint8Array> => Object.fromEntries(Object.entries(files).map(([path, f]) => [path, decodeFile(f)]));

function sameFiles(a: Record<string, string | Uint8Array>, b: Record<string, string | Uint8Array>): boolean {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length != kb.length || ka.some((k, i) => k != kb[i])) return false;
  return ka.every((k) => sameBytes(bytesOf(a[k]), bytesOf(b[k])));
}
const bytesOf = (data: string | Uint8Array) => (typeof data == "string" ? new TextEncoder().encode(data) : data);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length == b.length && a.every((x, i) => x == b[i]);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
