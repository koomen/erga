// Files dropped or pasted on the page in the editor (input.ts takes them): each goes into the document's files at its
// top, an image in images/ and any other file in files/, under its own name or, if a file has that name already, the
// name with -2, -3, ... before its extension. The editor puts them there itself, from the page's origin, with its edit
// key (PUT /d/<id>/api/files/<path>?key=: server/documents/routes.ts), then on the page where they were dropped: an
// image as an image, another file as a link to it. One file at a time; a file that fails doesn't stop the others.

import { encodePath } from "../../../document/pages";
import { sha256Hex } from "../../../shared/bytes";

/** Files over this size go with their sha-256, so they stream to storage (the server asks for it over 25 MB). */
const HASH_FROM = 20_000_000;

/** The folder a file goes in. */
const folderFor = (file: File) => (file.type.startsWith("image/") ? "images" : "files");

/** A file's name as it can be in the document: no folders, no dot at the start. */
const cleanName = (name: string) => name.replace(/[/\\]/g, "-").replace(/^\.+/, "").trim() || "file";

/**
 * Adds `file` to the document's files: `doc` is the document's address (https://<host>/d/<id>), `key` the edit key,
 * `taken` the paths the document has (any case), which gets the file's; `sending` hears its path before it goes.
 * Returns the path it got, or why it couldn't be added.
 */
export async function addFile(
  doc: string,
  key: string,
  file: File,
  taken: Set<string>,
  sending: (path: string) => void
): Promise<{ path: string } | { error: string }> {
  const dir = folderFor(file);
  const path = `${dir}/${unique(cleanName(file.name), (n) => taken.has(`${dir}/${n}`.toLowerCase()))}`;
  const headers: Record<string, string> = {};
  if (file.size > HASH_FROM) headers["x-erga-sha256"] = await sha256Hex(await file.arrayBuffer());
  sending(path);
  const r = await fetch(`${doc}/api/files/${encodePath(path)}?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    body: file,
    headers,
  }).catch(() => null);
  if (!r?.ok) return { error: await why(r) };
  taken.add(path.toLowerCase());
  return { path };
}

/** `name`, or with -2, -3, ... before its extension, the first that isn't `taken`. */
function unique(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name,
    ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) if (!taken(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
}

async function why(r: Response | null): Promise<string> {
  if (!r) return "The server didn't answer. Check the connection.";
  const body = (await r.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The server answered ${r.status}.`;
}
