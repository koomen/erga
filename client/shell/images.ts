// Images dropped on the page in the editor (the page's editor sends them: client/page-editor/input.ts, dropImages): each
// goes into the document's files, in images/ beside the page, under its own name or, if a file has that name already,
// the name with -2, -3, ... before its extension. The page's editor then puts them on the page where they were dropped.

import { encodePath, joinPath } from "../../document/pages";
import { sha256Hex } from "../../shared/bytes";

/** Files over this size go with their sha-256, so they stream to storage (the server asks for it over 25 MB). */
const HASH_FROM = 20_000_000;

/** A file's name as it can be in the document: no folders, no dot at the start. */
const cleanName = (name: string) => name.replace(/[/\\]/g, "-").replace(/^\.+/, "").trim() || "image";

/**
 * Adds `files` to the document's files (`api`: a path of the document's API to its address), in images/ in `folder`.
 * Returns the names they got, in order, up to the first that couldn't be added, and why it couldn't.
 */
export async function addImages(
  api: (path: string) => string,
  folder: string,
  files: File[]
): Promise<{ names: string[]; error: string | null }> {
  const dir = joinPath(folder.replace(/\/+$/, ""), "images");
  const listed = await fetch(api("/api/files"), { cache: "no-store" }).catch(() => null);
  if (!listed?.ok) return { names: [], error: await why(listed, "the image") };
  const taken = new Set(((await listed.json()) as { files: { path: string }[] }).files.map((f) => f.path.toLowerCase()));
  const names: string[] = [];
  for (const file of files) {
    const name = unique(cleanName(file.name), (n) => taken.has(joinPath(dir, n).toLowerCase()));
    const path = joinPath(dir, name);
    const headers: Record<string, string> = {};
    if (file.size > HASH_FROM) headers["x-erga-sha256"] = await sha256Hex(await file.arrayBuffer());
    const r = await fetch(api(`/api/files/${encodePath(path)}`), { method: "PUT", body: file, headers }).catch(() => null);
    if (!r?.ok) return { names, error: await why(r, file.name) };
    taken.add(path.toLowerCase());
    names.push(name);
  }
  return { names, error: null };
}

/** `name`, or with -2, -3, ... before its extension, the first that isn't `taken`. */
function unique(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) if (!taken(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}

async function why(r: Response | null, what: string): Promise<string> {
  if (!r) return `Couldn't add ${what}: the server didn't answer. Check the connection and drop it again.`;
  const body = (await r.json().catch(() => null)) as { error?: string } | null;
  return `Couldn't add ${what}: ${body?.error ?? `the server answered ${r.status}.`}`;
}
