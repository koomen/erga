#!/usr/bin/env bun
// The storage cutover, part two: the documents of an export folder
// (export.ts) back into a server, each under its own id, through
// POST /api/admin/documents/import (server/admin/cutover.ts) with an
// admin-scope token. The directory's rows are already there (D1 is not part
// of the cutover); the import refuses a document whose row is missing or
// whose owner differs, and one that exists already.
//
//   ERGA_TOKEN=erga_... bun deploy/cutover/import.ts https://erga.dev ~/erga-export
//
// Then it checks: it reads every document back through the export route and
// compares each file's bytes with the folder's. It prints what differs, and
// exits 1 if anything does.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { decodeFile, type ExportedDocument, type ExportedFile, type ExportLine } from "../../server/admin/cutover.ts";

const [server, folder] = process.argv.slice(2);
const token = process.env.ERGA_TOKEN;
if (!server || !folder || !token) { console.error("usage: ERGA_TOKEN=erga_... bun deploy/cutover/import.ts <server url> <folder>"); process.exit(2); }
const headers = { Authorization: `Bearer ${token}` };

const root = resolve(folder);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { ids: string[]; server: string; at: string };
console.log(`${manifest.ids.length} documents exported from ${manifest.server} at ${manifest.at}`);

/** Every file under `dir` (relative path → bytes). */
function filesUnder(dir: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => { for (const name of readdirSync(d)) { const full = join(d, name); if (statSync(full).isDirectory()) walk(full); else out[relative(dir, full).split("\\").join("/")] = new Uint8Array(readFileSync(full)); } };
  walk(dir);
  return out;
}
const encode = (files: Record<string, Uint8Array>): Record<string, ExportedFile> => Object.fromEntries(Object.entries(files).map(([p, b]) => [p, { base64: Buffer.from(b).toString("base64") }]));

let imported = 0, refused = 0;
for (const id of manifest.ids) {
  const dir = join(root, id);
  const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as Omit<ExportedDocument, "files" | "publishedFiles"> & { files: string[]; publishedFiles?: string[] };
  const files = filesUnder(join(dir, "files"));
  const published = record.publishedFiles ? filesUnder(join(dir, "published")) : null;
  const { files: _names, publishedFiles: _published, ...rest } = record;
  const body: ExportedDocument = { ...rest, files: encode(files), ...(published ? { publishedFiles: encode(published) } : {}) };
  const res = await fetch(new URL("/api/admin/documents/import", server), { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const answer = (await res.json()) as { ok?: boolean; versions?: number; error?: string };
  if (res.ok && answer.ok) { imported++; console.log(`${record.record.owner}/${record.record.slug} (${id}): imported, ${Object.keys(files).length} files, ${answer.versions} version${answer.versions == 1 ? "" : "s"}`); }
  else { refused++; console.log(`${record.record.owner}/${record.record.slug} (${id}): REFUSED (${res.status}): ${answer.error ?? JSON.stringify(answer)}`); }
}
console.log(`${imported} imported, ${refused} refused`);

// The check: every document read back, file by file.
const res = await fetch(new URL("/api/admin/documents/export", server), { headers });
if (!res.ok) { console.error(`the check couldn't read the documents back: ${res.status} ${await res.text()}`); process.exit(1); }
const back = new Map<string, ExportLine>();
for (const raw of (await res.text()).split("\n")) if (raw.trim()) { const line = JSON.parse(raw) as ExportLine; back.set(line.record.id, line); }
let wrong = 0;
const same = (a: Uint8Array, b: Uint8Array) => a.length == b.length && a.every((x, i) => x == b[i]);
for (const id of manifest.ids) {
  const line = back.get(id);
  const dir = join(root, id);
  if (!line || "missing" in line) { wrong++; console.log(`${id}: not on the server after the import`); continue; }
  for (const [sub, want] of [["files", filesUnder(join(dir, "files"))], ["published", existsSync(join(dir, "published")) ? filesUnder(join(dir, "published")) : null]] as const) {
    if (!want) continue;
    const got = sub == "files" ? line.files : (line.publishedFiles ?? line.files);
    const paths = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const p of paths) {
      if (!(p in want)) { wrong++; console.log(`${id} ${sub}/${p}: on the server, not in the folder`); continue; }
      if (!(p in got)) { wrong++; console.log(`${id} ${sub}/${p}: in the folder, not on the server`); continue; }
      if (!same(want[p], decodeFile(got[p]))) { wrong++; console.log(`${id} ${sub}/${p}: the bytes differ`); }
    }
  }
}
console.log(wrong ? `${wrong} differences` : `checked: every file of ${manifest.ids.length} documents is back, byte for byte`);
process.exit(wrong || refused ? 1 : 0);
