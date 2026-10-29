// Files dropped or pasted on the page in the editor (the page's editor sends them: client/page-editor/input.ts): each
// goes into the document's files at its top, an image in images/ and any other file in files/, under its own name or,
// if a file has that name already, the name with -2, -3, ... before its extension. The page's editor then puts them on
// the page where they were dropped: an image as an image, another file as a link to it.

import { encodePath } from "../../document/pages";
import { sha256Hex } from "../../shared/bytes";

/** Files over this size go with their sha-256, so they stream to storage (the server asks for it over 25 MB). */
const HASH_FROM = 20_000_000;

/** The folder a file goes in. */
export const folderFor = (file: File) => (file.type.startsWith("image/") ? "images" : "files");

/** A file's name as it can be in the document: no folders, no dot at the start. */
const cleanName = (name: string) => name.replace(/[/\\]/g, "-").replace(/^\.+/, "").trim() || "file";

/**
 * Adds `files` to the document's files (`api`: a path of the document's API to its address). Returns the paths they
 * got, in order, up to the first that couldn't be added, and why it couldn't.
 */
export async function addFiles(api: (path: string) => string, files: File[]): Promise<{ paths: string[]; error: string | null }> {
  const listed = await fetch(api("/api/files"), { cache: "no-store" }).catch(() => null);
  if (!listed?.ok) return { paths: [], error: await why(listed, files.length == 1 ? files[0].name : "the files") };
  const taken = new Set(((await listed.json()) as { files: { path: string }[] }).files.map((f) => f.path.toLowerCase()));
  const paths: string[] = [];
  for (const file of files) {
    const dir = folderFor(file);
    const path = `${dir}/${unique(cleanName(file.name), (n) => taken.has(`${dir}/${n}`.toLowerCase()))}`;
    const headers: Record<string, string> = {};
    if (file.size > HASH_FROM) headers["x-erga-sha256"] = await sha256Hex(await file.arrayBuffer());
    const r = await fetch(api(`/api/files/${encodePath(path)}`), { method: "PUT", body: file, headers }).catch(() => null);
    if (!r?.ok) return { paths, error: await why(r, file.name) };
    taken.add(path.toLowerCase());
    paths.push(path);
  }
  return { paths, error: null };
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
