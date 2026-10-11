#!/usr/bin/env bun
// The storage cutover, part one: every document of a server, to a folder on
// this machine. Reads GET /api/admin/documents/export (server/admin/cutover.ts)
// with an admin-scope token, and writes nothing on the server.
//
//   ERGA_TOKEN=erga_... bun deploy/cutover/export.ts https://erga.dev ~/erga-export
//
// The folder gets one subfolder per document, by id:
//
//   <id>/record.json     the directory's row, who has it, the page, and the published state
//   <id>/files/...       every file as it is now
//   <id>/published/...   the published version's files, only when it is fixed at another version
//
// and manifest.json: every id, with the time of the export. Run again on the
// same folder, it replaces each document's subfolder (a document that is
// gone from the server is left; the manifest says which ids this run saw).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeFile, type ExportLine } from "../../server/admin/cutover.ts";

const [server, folder] = process.argv.slice(2);
const token = process.env.ERGA_TOKEN;
if (!server || !folder || !token) { console.error("usage: ERGA_TOKEN=erga_... bun deploy/cutover/export.ts <server url> <folder>"); process.exit(2); }

const out = resolve(folder);
mkdirSync(out, { recursive: true });
const res = await fetch(new URL("/api/admin/documents/export", server), { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok || !res.body) { console.error(`${server}: ${res.status} ${await res.text()}`); process.exit(1); }

const ids: string[] = [];
let files = 0, bytes = 0, missing = 0;
const text = await res.text();
for (const raw of text.split("\n")) {
  if (!raw.trim()) continue;
  const line = JSON.parse(raw) as ExportLine | { error: string };
  if ("error" in line) { console.error(`the server stopped: ${line.error}`); process.exit(1); }
  const dir = join(out, line.record.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if ("missing" in line) { missing++; writeFileSync(join(dir, "record.json"), JSON.stringify({ record: line.record, missing: true }, null, 2)); console.log(`${line.record.owner}/${line.record.slug} (${line.record.id}): no storage (never made)`); continue; }
  const { files: current, publishedFiles, ...rest } = line;
  writeFileSync(join(dir, "record.json"), JSON.stringify({ ...rest, files: Object.keys(current), publishedFiles: publishedFiles ? Object.keys(publishedFiles) : undefined }, null, 2));
  for (const [sub, set] of [["files", current], ["published", publishedFiles]] as const) {
    if (!set) continue;
    for (const [path, file] of Object.entries(set)) {
      const data = decodeFile(file);
      const full = join(dir, sub, path);
      if (!full.startsWith(join(dir, sub) + "/")) throw new Error(`${line.record.id}: refusing the path ${path}`);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      files++; bytes += data.length;
    }
  }
  ids.push(line.record.id);
  console.log(`${line.record.owner}/${line.record.slug} (${line.record.id}): ${Object.keys(current).length} files${publishedFiles ? `, published at ${line.published?.version.id} (${Object.keys(publishedFiles).length} files)` : ""}`);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify({ server, at: new Date().toISOString(), ids }, null, 2));
console.log(`${ids.length} documents, ${files} files, ${(bytes / 1e6).toFixed(1)} MB in ${out}${missing ? `; ${missing} without storage` : ""}`);
